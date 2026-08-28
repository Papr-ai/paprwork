#!/usr/bin/env node
/**
 * Metadata-only local vs Turso schema diff (PRAGMA table_info — no row scans).
 *
 * Usage:
 *   PAPR_API_KEY=... node scripts/probe-schema-drift-diff.mjs \
 *     --local-db=/path/to/data.db \
 *     --replica-id=d-8efa46c2 \
 *     [--external-user-id=WkPutXGdqg] \
 *     [--memory-base=https://memory.papr.ai]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createClient } from "@libsql/client";

const SCRATCH = new Set([
  "_papr_sync_log",
  "_papr_sync_meta",
  "_papr_sync_mute",
  "_papr_sync_infra",
  "_papr_schema_migrations",
  "_papr_oplog",
  "_papr_materialized",
  "lost_and_found",
  "schema_migrations",
  "turso_sync_last_change_id",
  "turso_sync_state",
  "turso_sync_cursor",
  "turso_sync_meta",
  "turso_sync_log",
  "turso_sync_registry",
]);

function loadEnvLocal() {
  try {
    const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

function parseArgs() {
  const out = {
    localDb: "",
    replicaId: "",
    externalUserId: undefined,
    memoryBase: "https://memory.papr.ai",
  };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--local-db=")) out.localDb = arg.slice("--local-db=".length);
    else if (arg.startsWith("--replica-id=")) out.replicaId = arg.slice("--replica-id=".length);
    else if (arg.startsWith("--external-user-id=")) {
      out.externalUserId = arg.slice("--external-user-id=".length);
    } else if (arg.startsWith("--memory-base=")) {
      out.memoryBase = arg.slice("--memory-base=".length).replace(/\/$/, "");
    }
  }
  if (!out.localDb || !out.replicaId) {
    throw new Error("Required: --local-db=PATH --replica-id=d-xxxxxxxx");
  }
  return out;
}

function sqliteQuery(dbPath, sql) {
  const out = execFileSync("sqlite3", ["-separator", "|", dbPath, sql], {
    encoding: "utf8",
  }).trim();
  if (!out) return [];
  return out.split("\n");
}

function listUserTables(dbPath) {
  return sqliteQuery(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
}

function filterSyncableTables(names) {
  return names.filter(
    (name) =>
      !SCRATCH.has(name) &&
      !name.startsWith("turso_cdc_"),
  );
}

function readTableSchema(dbPath, tableName) {
  const quoted = `"${tableName.replace(/"/g, '""')}"`;
  const rows = sqliteQuery(
    dbPath,
    `PRAGMA table_info(${quoted})`,
  );
  return rows.map((line) => {
    const [cid, name, type, notnull, dflt, pk] = line.split("|");
    return {
      name: String(name ?? ""),
      type: String(type ?? ""),
      primaryKey: Number(pk ?? 0) === 1,
    };
  });
}

function isPlatformColumn(name) {
  return name.startsWith("_papr_");
}

function userColumns(columns) {
  return columns.filter((col) => !isPlatformColumn(col.name));
}

function schemaSig(columns) {
  return [...columns]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((col) => `${col.name}:${col.type}:${col.primaryKey ? 1 : 0}`)
    .join(",");
}

async function readRemoteTableSchema(client, tableName) {
  const quoted = `"${tableName.replace(/"/g, '""')}"`;
  const result = await client.execute(`PRAGMA table_info(${quoted})`);
  return result.rows.map((row) => ({
    name: String(row.name ?? ""),
    type: String(row.type ?? ""),
    primaryKey: Number(row.pk ?? 0) === 1,
  }));
}

async function fetchTursoToken(base, apiKey, database, externalUserId) {
  const body = { database };
  if (externalUserId) body.external_user_id = externalUserId;
  const res = await fetch(`${base}/v1/cloud/databases/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`db token ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

function diffColumns(localCols, remoteCols) {
  const localNames = new Map(localCols.map((c) => [c.name, c]));
  const remoteNames = new Map(remoteCols.map((c) => [c.name, c]));
  const onlyLocal = [];
  const onlyRemote = [];
  const typeMismatch = [];
  for (const [name, col] of localNames) {
    const remote = remoteNames.get(name);
    if (!remote) {
      onlyLocal.push(col);
      continue;
    }
    const ls = `${col.type}:${col.primaryKey ? 1 : 0}`;
    const rs = `${remote.type}:${remote.primaryKey ? 1 : 0}`;
    if (ls !== rs) {
      typeMismatch.push({ name, local: col, remote });
    }
  }
  for (const [name, col] of remoteNames) {
    if (!localNames.has(name)) onlyRemote.push(col);
  }
  return { onlyLocal, onlyRemote, typeMismatch };
}

async function main() {
  loadEnvLocal();
  const args = parseArgs();
  const apiKey = process.env.PAPR_API_KEY?.trim();
  if (!apiKey) throw new Error("PAPR_API_KEY required");

  const tableNames = filterSyncableTables(listUserTables(args.localDb));
  console.log(`Local DB: ${args.localDb}`);
  console.log(`Replica:  ${args.replicaId}`);
  console.log(`Tables (syncable user): ${tableNames.length}\n`);

  const creds = await fetchTursoToken(
    args.memoryBase,
    apiKey,
    args.replicaId,
    args.externalUserId,
  );
  console.log(`Turso URL: ${creds.tursoUrl}\n`);

  const remote = createClient({
    url: creds.tursoUrl,
    authToken: creds.authToken,
  });

  try {
    const drifted = [];
    for (const tableName of tableNames) {
      const localCols = userColumns(readTableSchema(args.localDb, tableName));
      const exists = await remote.execute({
        sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
        args: [tableName],
      });
      if (exists.rows.length === 0) {
        drifted.push({ tableName, issue: "missing_on_remote", detail: null });
        continue;
      }
      const remoteCols = userColumns(await readRemoteTableSchema(remote, tableName));
      if (schemaSig(localCols) !== schemaSig(remoteCols)) {
        drifted.push({
          tableName,
          issue: "column_mismatch",
          detail: diffColumns(localCols, remoteCols),
        });
      }
    }

    console.log("=== Schema drift (user columns only) ===");
    if (drifted.length === 0) {
      console.log("No drift detected.");
    } else {
      for (const item of drifted) {
        console.log(`\n• ${item.tableName}: ${item.issue}`);
        if (item.detail) {
          if (item.detail.onlyLocal.length) {
            console.log(
              "  columns only on local:",
              item.detail.onlyLocal.map((c) => `${c.name} ${c.type}`).join(", "),
            );
          }
          if (item.detail.onlyRemote.length) {
            console.log(
              "  columns only on remote:",
              item.detail.onlyRemote.map((c) => `${c.name} ${c.type}`).join(", "),
            );
          }
          for (const mm of item.detail.typeMismatch) {
            console.log(
              `  type mismatch ${mm.name}: local=${mm.local.type} remote=${mm.remote.type}`,
            );
          }
        }
      }
    }

    console.log("\n=== Remote _papr_schema_migrations (ledger) ===");
    try {
      const ledger = await remote.execute(
        "SELECT id, applied_at, source FROM _papr_schema_migrations ORDER BY applied_at",
      );
      if (ledger.rows.length === 0) {
        console.log("(empty)");
      } else {
        for (const row of ledger.rows) {
          console.log(
            `  ${row.id} @ ${row.applied_at} source=${row.source}`,
          );
        }
      }
    } catch (err) {
      console.log("(table missing or unreadable)", err instanceof Error ? err.message : err);
    }

    console.log("\n=== Remote _papr_oplog (schema entries) ===");
    try {
      const oplog = await remote.execute(
        "SELECT seq, kind, hlc, substr(payload,1,120) AS payload_preview FROM _papr_oplog WHERE kind IN ('schema','snapshot') ORDER BY seq",
      );
      if (oplog.rows.length === 0) {
        console.log("(empty)");
      } else {
        for (const row of oplog.rows) {
          console.log(`  seq=${row.seq} kind=${row.kind} hlc=${row.hlc}`);
          console.log(`    ${row.payload_preview}…`);
        }
      }
    } catch (err) {
      console.log("(table missing or unreadable)", err instanceof Error ? err.message : err);
    }

    console.log("\n=== Local schema_migrations ===");
    try {
      const localMigs = sqliteQuery(
        args.localDb,
        "SELECT id, applied_at FROM schema_migrations ORDER BY applied_at",
      );
      if (localMigs.length === 0) {
        console.log("(empty)");
      } else {
        for (const line of localMigs) {
          const [id, appliedAt] = line.split("|");
          console.log(`  ${id} @ ${appliedAt}`);
        }
      }
    } catch {
      console.log("(no schema_migrations table)");
    }
  } finally {
    remote.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
