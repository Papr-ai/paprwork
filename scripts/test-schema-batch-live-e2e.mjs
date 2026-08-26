#!/usr/bin/env node
/**
 * Live E2E — all schema migration op types against memory server + Turso.
 *
 * Prerequisites:
 *   cd ../memory && poetry run python main.py   # :5001
 *   TEST_X_USER_API_KEY or PAPR_API_KEY in env (memory .env works)
 *
 * Usage:
 *   PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001 \
 *     node scripts/test-schema-batch-live-e2e.mjs
 */

import { randomUUID, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const memoryBase = (
  process.env.PAPR_MEMORY_SERVER_URL ?? "http://127.0.0.1:5001"
).replace(/\/$/, "");

function loadApiKey() {
  if (process.env.PAPR_API_KEY?.trim()) return process.env.PAPR_API_KEY.trim();
  if (process.env.TEST_X_USER_API_KEY?.trim()) {
    return process.env.TEST_X_USER_API_KEY.trim();
  }
  const memoryEnv = join(__dirname, "../../memory/.env");
  if (existsSync(memoryEnv)) {
    for (const line of readFileSync(memoryEnv, "utf8").split("\n")) {
      const m = /^(?:TEST_X_USER_API_KEY|PAPR_API_KEY)=(.*)$/.exec(line.trim());
      if (m?.[1]?.trim()) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  for (const settingsPath of [
    join(homedir(), "Papr", "data", "settings.json"),
    join(homedir(), ".paprwork-v2", "settings.json"),
  ]) {
    try {
      if (!existsSync(settingsPath)) continue;
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const key =
        settings?.customKeys?.PAPR_API_KEY ?? settings?.paprProfile?.apiKey;
      if (key) return key;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Match Python json.dumps(..., separators=(",", ":"), sort_keys=True). */
function canonicalJsonStringify(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJsonStringify(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(migrationId, { ops = null, statements = null } = {}) {
  const canonical = canonicalJsonStringify({
    migrationId,
    ops,
    statements,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function memoryFetch(path, init = {}) {
  const resp = await fetch(`${memoryBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      "X-Client-Type": "papr_plugin",
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(180_000),
  });
  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: resp.status, data, text };
}

const apiKey = loadApiKey();
if (!apiKey) {
  console.error("❌ PAPR_API_KEY or TEST_X_USER_API_KEY required");
  process.exit(1);
}

const replicaId = `j-batch${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const tableName = `e2e_schema_${Date.now().toString(36)}`;
const indexName = `idx_${tableName}_n`;
const appId = "e2e-schema-batch-live";

function schemaEntry(migrationId, payloadExtra) {
  const { ops, statements } = payloadExtra;
  return {
    kind: "schema",
    dbSourceId: "primary",
    payload: {
      appId,
      dbSlug: "primary",
      migrationId,
      contentHash: contentHash(migrationId, { ops, statements }),
      ...payloadExtra,
    },
  };
}

async function insertRow(sql, params) {
  const rowRes = await memoryFetch("/v1/cloud/workspace/log/append", {
    method: "POST",
    body: {
      replicaId,
      kind: "row",
      dbSourceId: "primary",
      payload: { appId, sql, params },
    },
  });
  if (rowRes.status !== 200) {
    throw new Error(
      `row insert failed (${rowRes.status}): ${String(rowRes.text).slice(0, 300)}`,
    );
  }
  return rowRes.data;
}

async function main() {
  console.log(`Memory: ${memoryBase}`);
  console.log(`Replica: ${replicaId}`);
  console.log(`Table: ${tableName}`);

  const health = await fetch(`${memoryBase}/health`, {
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!health?.ok) {
    console.error(
      "❌ Memory server not reachable — start with: cd ../memory && poetry run python main.py",
    );
    process.exit(1);
  }
  console.log("✅ Memory server health OK");

  const entries = [
    schemaEntry("0001_create", {
      statements: [
        `CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)`,
      ],
    }),
    schemaEntry("0002_add_col_sql", {
      statements: [`ALTER TABLE ${tableName} ADD COLUMN label TEXT`],
    }),
    schemaEntry("0003_add_col_op", {
      ops: [
        {
          kind: "add_column",
          table: tableName,
          column: "note",
          type: "TEXT",
        },
      ],
    }),
    schemaEntry("0004_create_index", {
      statements: [
        `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(n)`,
      ],
    }),
    schemaEntry("0005_rename_col", {
      ops: [
        {
          kind: "rename_column",
          table: tableName,
          from: "label",
          to: "title",
        },
      ],
    }),
    schemaEntry("0006_drop_col", {
      ops: [
        {
          kind: "drop_column",
          table: tableName,
          column: "note",
        },
      ],
    }),
  ];

  const batchRes = await memoryFetch("/v1/cloud/workspace/log/append-batch", {
    method: "POST",
    body: { replicaId, entries },
  });

  if (batchRes.status !== 200) {
    console.error(
      `❌ append-batch failed (${batchRes.status}): ${String(batchRes.text).slice(0, 400)}`,
    );
    process.exit(1);
  }

  const { firstSeq, lastSeq, count, schemaAppliedCount, latencyMs } =
    batchRes.data ?? {};
  if (count !== entries.length || lastSeq - firstSeq + 1 !== entries.length) {
    console.error(`❌ bad seq range: ${JSON.stringify(batchRes.data)}`);
    process.exit(1);
  }
  if (schemaAppliedCount !== entries.length) {
    console.error(
      `❌ schemaAppliedCount expected ${entries.length}, got ${schemaAppliedCount}`,
    );
    process.exit(1);
  }
  console.log(
    `✅ append-batch schemaAppliedCount=${schemaAppliedCount} seq=${firstSeq}..${lastSeq} latencyMs=${latencyMs}`,
  );

  const row = await insertRow(
    `INSERT INTO ${tableName} (id, n, title) VALUES (?, ?, ?)`,
    [1, 42, "live-all-ops"],
  );
  if (typeof row?.changes !== "number" || row.changes < 1) {
    console.error(`❌ row insert changes: ${JSON.stringify(row)}`);
    process.exit(1);
  }
  console.log(`✅ row insert after all schema ops (changes=${row.changes})`);

  // Idempotency — re-ship same batch hashes; should skip apply but still succeed.
  const replayRes = await memoryFetch("/v1/cloud/workspace/log/append-batch", {
    method: "POST",
    body: { replicaId, entries },
  });
  if (replayRes.status !== 200) {
    console.error(
      `❌ idempotent replay failed (${replayRes.status}): ${String(replayRes.text).slice(0, 300)}`,
    );
    process.exit(1);
  }
  console.log("✅ idempotent replay of same migrations succeeded");

  console.log("\nAll live schema migration op checks passed.");
}

main().catch((err) => {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
